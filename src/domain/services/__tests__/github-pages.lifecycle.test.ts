import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { CloudflareAdapter, type CloudflareDnsRecord } from '../../../adapters/providers/cloudflare/cloudflare.adapter.js';
import { GitHubAdapter, type GitHubPagesConfig } from '../../../adapters/providers/github/github.adapter.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { executePlanApply } from '../../../application/apply-plan.js';
import { createToolContext } from '../../../tools/context.js';
import { PlanService } from '../../plan/plan.service.js';
import { SpecStore } from '../../spec/spec.store.js';
import { projectSpecSchema, type ProjectSpec } from '../../spec/spec.schema.js';
import { compileManagedGitHubFiles } from '../github-infrastructure.service.js';
import {
  applyGitHubPages,
  applyGitHubPagesDns,
  compileGitHubPagesWorkflow,
  GITHUB_PAGES_ACTION_ID,
  GITHUB_PAGES_DNS_OPERATION,
  planGitHubPages,
} from '../github-pages.service.js';

const REPOSITORY = 'owner/pages-fixture';
const PAGES_IPS = ['185.199.108.153', '185.199.109.153', '185.199.110.153', '185.199.111.153'];

function spec(project: string): ProjectSpec {
  return projectSpecSchema.parse({
    version: 1,
    project,
    gitRemoteUrl: `https://github.com/${REPOSITORY}.git`,
    github: {
      repository: REPOSITORY,
      canonicalEnvironment: 'repository',
      collaboration: {
        issues: { enabled: false, templates: false },
        pullRequests: { requirePr: false },
      },
      pages: {
        sourcePath: 'apps/website',
        branch: 'main',
        customDomain: 'hypervibe.dev',
      },
    },
    environments: {},
  });
}

function pageConfig(overrides: Partial<GitHubPagesConfig> = {}): GitHubPagesConfig {
  return {
    url: 'https://owner.github.io/pages-fixture/',
    cname: 'hypervibe.dev',
    custom_404: false,
    public: true,
    build_type: 'workflow',
    https_enforced: false,
    https_certificate: { state: 'issued', description: '', domains: ['hypervibe.dev'] },
    ...overrides,
  };
}

function dnsRecord(id: string, type: string, content: string, name = 'hypervibe.dev'): CloudflareDnsRecord {
  return {
    id,
    zone_id: 'zone-1',
    zone_name: 'hypervibe.dev',
    name,
    type,
    content,
    proxied: false,
    proxiable: true,
    ttl: 1,
    created_on: '2026-08-05T00:00:00Z',
    modified_on: '2026-08-05T00:00:00Z',
  };
}

describe('declarative GitHub Pages lifecycle', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-pages-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('compiles the reviewed artifact workflow with the supported Pages actions and permissions', () => {
    const pages = spec('pages-workflow').github!.pages!;
    const workflow = compileGitHubPagesWorkflow(pages);

    expect(workflow).toContain('pages: write');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('uses: actions/configure-pages@v5');
    expect(workflow).toContain('uses: actions/upload-pages-artifact@v4');
    expect(workflow).toContain('uses: actions/deploy-pages@v4');
    expect(workflow).toContain('path: "apps/website"');
  });

  it('plans and applies Pages for a repository-only project without inventing a hosting environment', async () => {
    const project = new ProjectRepository().create({
      name: 'pages-project',
      gitRemoteUrl: `https://github.com/${REPOSITORY}.git`,
    });
    const desiredSpec = spec(project.name);
    const stored = new SpecStore().replace(project, desiredSpec);
    for (const [provider, scope, credentials] of [
      ['github', REPOSITORY, { apiToken: 'github-token' }],
      ['cloudflare', 'hypervibe.dev', { apiToken: 'cloudflare-token' }],
    ] as const) {
      const connection = new ConnectionRepository().create({
        provider,
        scope,
        credentialsEncrypted: getSecretStore().encryptObject(credentials),
      });
      new ConnectionRepository().updateStatus(connection.id, 'verified');
    }

    const files = new Map(compileManagedGitHubFiles(desiredSpec.github!).map((file) => [file.path, file.content]));
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockImplementation(async (_owner, _repo, file) => files.get(file) ?? null);
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main', private: false });
    vi.spyOn(GitHubAdapter.prototype, 'listLabels').mockResolvedValue([]);
    vi.spyOn(CloudflareAdapter.prototype, 'findZoneByName').mockResolvedValue({
      id: 'zone-1', name: 'hypervibe.dev', status: 'active', paused: false, type: 'full', name_servers: [],
    });
    vi.spyOn(CloudflareAdapter.prototype, 'listDnsRecords').mockResolvedValue(
      [
        ...PAGES_IPS.map((ip, index) => dnsRecord(`pages-${index}`, 'A', ip)),
        dnsRecord('pages-www', 'CNAME', 'owner.github.io', 'www.hypervibe.dev'),
      ]
    );
    vi.spyOn(GitHubAdapter.prototype, 'getPagesConfig')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(pageConfig())
      .mockResolvedValueOnce(pageConfig({ https_enforced: true }));
    const create = vi.spyOn(GitHubAdapter.prototype, 'createPagesSite').mockResolvedValue();
    const update = vi.spyOn(GitHubAdapter.prototype, 'updatePagesSite').mockResolvedValue();
    const trigger = vi.spyOn(GitHubAdapter.prototype, 'triggerWorkflow').mockResolvedValue();
    const dnsCreate = vi.spyOn(CloudflareAdapter.prototype, 'createDnsRecord');
    const dnsDelete = vi.spyOn(CloudflareAdapter.prototype, 'deleteDnsRecord');

    const planned = await new PlanService().plan(project, 'repository');
    expect(planned).not.toHaveProperty('error');
    const plan = planned as Exclude<typeof planned, { error: string }>;
    expect(plan.actions.find((action) => action.id === GITHUB_PAGES_ACTION_ID)).toMatchObject({ type: 'create' });

    const outcome = await executePlanApply(createToolContext(), {
      project,
      spec: stored.spec,
      specRevision: stored.revision,
      planId: plan.planRunId,
      confirmActions: [],
    });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: {
        success: false,
        receipts: expect.arrayContaining([
          expect.objectContaining({ actionId: GITHUB_PAGES_ACTION_ID, status: 'pending' }),
        ]),
      },
    });
    expect(create).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledTimes(2);
    expect(trigger).toHaveBeenCalledWith('owner', 'pages-fixture', '.github/workflows/hypervibe-pages.yml', 'main');
    expect(dnsCreate).not.toHaveBeenCalled();
    expect(dnsDelete).not.toHaveBeenCalled();
  });

  it('adds the recommended www CNAME for an apex domain without replacement confirmation', async () => {
    const project = new ProjectRepository().create({ name: 'pages-www' });
    const desiredSpec = spec(project.name);
    const connection = new ConnectionRepository().create({
      provider: 'cloudflare',
      scope: 'hypervibe.dev',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'cloudflare-token' }),
    });
    new ConnectionRepository().updateStatus(connection.id, 'verified');

    const records = PAGES_IPS.map((ip, index) => dnsRecord(`pages-${index}`, 'A', ip));
    vi.spyOn(CloudflareAdapter.prototype, 'findZoneByName').mockResolvedValue({
      id: 'zone-1', name: 'hypervibe.dev', status: 'active', paused: false, type: 'full', name_servers: [],
    });
    vi.spyOn(CloudflareAdapter.prototype, 'listDnsRecords').mockImplementation(async () => [...records]);
    vi.spyOn(GitHubAdapter.prototype, 'getPagesConfig').mockResolvedValue(pageConfig({ https_enforced: true }));
    const adapter = new GitHubAdapter();
    adapter.connect({ apiToken: 'github-token' });

    const planned = await planGitHubPages({ spec: desiredSpec, repository: REPOSITORY, adapter });
    const dnsAction = planned.actions.find((action) => action.metadata?.operation === GITHUB_PAGES_DNS_OPERATION)!;
    expect(dnsAction).toMatchObject({ type: 'update' });
    expect(dnsAction.requiresConfirm).toBeUndefined();

    const remove = vi.spyOn(CloudflareAdapter.prototype, 'deleteDnsRecord');
    const create = vi.spyOn(CloudflareAdapter.prototype, 'createDnsRecord').mockImplementation(async (_zone, input) => {
      const created = dnsRecord(`new-${records.length}`, input.type, input.content, input.name);
      records.push(created);
      return created;
    });

    const applied = await applyGitHubPagesDns({ spec: desiredSpec, action: dnsAction });

    expect(applied.success).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith('zone-1', {
      name: 'www.hypervibe.dev',
      type: 'CNAME',
      content: 'owner.github.io',
      proxied: false,
    });
  });

  it('confirmation-gates replacement records and preserves non-address DNS records', async () => {
    const project = new ProjectRepository().create({ name: 'pages-dns' });
    const desiredSpec = spec(project.name);
    const connection = new ConnectionRepository().create({
      provider: 'cloudflare',
      scope: 'hypervibe.dev',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'cloudflare-token' }),
    });
    new ConnectionRepository().updateStatus(connection.id, 'verified');

    const records = [
      dnsRecord('old-address', 'A', '192.0.2.10'),
      dnsRecord('mail', 'MX', 'mail.example.net'),
    ];
    vi.spyOn(CloudflareAdapter.prototype, 'findZoneByName').mockResolvedValue({
      id: 'zone-1', name: 'hypervibe.dev', status: 'active', paused: false, type: 'full', name_servers: [],
    });
    vi.spyOn(CloudflareAdapter.prototype, 'listDnsRecords').mockImplementation(async () => [...records]);
    vi.spyOn(GitHubAdapter.prototype, 'getPagesConfig').mockResolvedValue(pageConfig({ https_enforced: true }));
    const adapter = new GitHubAdapter();
    adapter.connect({ apiToken: 'github-token' });
    const planned = await planGitHubPages({ spec: desiredSpec, repository: REPOSITORY, adapter });
    const dnsAction = planned.actions.find((action) => action.metadata?.operation === GITHUB_PAGES_DNS_OPERATION)!;
    expect(dnsAction).toMatchObject({ type: 'update', requiresConfirm: true });
    expect(dnsAction.metadata?.observedRecords).toEqual([
      { id: 'old-address', name: 'hypervibe.dev', type: 'A', content: '192.0.2.10', proxied: false },
    ]);

    const remove = vi.spyOn(CloudflareAdapter.prototype, 'deleteDnsRecord').mockImplementation(async (_zone, id) => {
      records.splice(records.findIndex((record) => record.id === id), 1);
      return { id };
    });
    vi.spyOn(CloudflareAdapter.prototype, 'createDnsRecord').mockImplementation(async (_zone, input) => {
      const created = dnsRecord(`new-${records.length}`, input.type, input.content, input.name);
      records.push(created);
      return created;
    });

    const applied = await applyGitHubPagesDns({
      spec: desiredSpec,
      action: dnsAction,
    });

    expect(applied.success).toBe(true);
    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('zone-1', 'old-address');
    expect(records.find((record) => record.id === 'mail')).toBeDefined();
  });

  it('removes only exact Hypervibe-managed apex and www records during teardown', async () => {
    const project = new ProjectRepository().create({ name: 'pages-teardown' });
    const enabledSpec = spec(project.name);
    const desiredSpec = projectSpecSchema.parse({
      ...enabledSpec,
      github: {
        ...enabledSpec.github,
        pages: { ...enabledSpec.github!.pages, enabled: false },
      },
    });
    const connection = new ConnectionRepository().create({
      provider: 'cloudflare',
      scope: 'hypervibe.dev',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'cloudflare-token' }),
    });
    new ConnectionRepository().updateStatus(connection.id, 'verified');

    const records = [
      ...PAGES_IPS.map((ip, index) => dnsRecord(`pages-${index}`, 'A', ip)),
      dnsRecord('pages-www', 'CNAME', 'owner.github.io', 'www.hypervibe.dev'),
      dnsRecord('mail', 'MX', 'mail.example.net'),
    ];
    vi.spyOn(CloudflareAdapter.prototype, 'findZoneByName').mockResolvedValue({
      id: 'zone-1', name: 'hypervibe.dev', status: 'active', paused: false, type: 'full', name_servers: [],
    });
    vi.spyOn(CloudflareAdapter.prototype, 'listDnsRecords').mockImplementation(async () => [...records]);
    vi.spyOn(GitHubAdapter.prototype, 'getPagesConfig').mockResolvedValue(pageConfig({ https_enforced: true }));
    const adapter = new GitHubAdapter();
    adapter.connect({ apiToken: 'github-token' });

    const planned = await planGitHubPages({ spec: desiredSpec, repository: REPOSITORY, adapter });
    const dnsAction = planned.actions.find((action) => action.metadata?.operation === GITHUB_PAGES_DNS_OPERATION)!;
    expect(dnsAction).toMatchObject({ type: 'destroy', requiresConfirm: true });

    const remove = vi.spyOn(CloudflareAdapter.prototype, 'deleteDnsRecord').mockImplementation(async (_zone, id) => {
      records.splice(records.findIndex((record) => record.id === id), 1);
      return { id };
    });
    const applied = await applyGitHubPagesDns({ spec: desiredSpec, action: dnsAction });

    expect(applied.success).toBe(true);
    expect(remove).toHaveBeenCalledTimes(5);
    expect(records).toEqual([expect.objectContaining({ id: 'mail', type: 'MX' })]);
  });

  it('orders DNS before Pages configuration so certificate-pending work cannot strand DNS', async () => {
    const desiredSpec = spec('pages-ordering');
    const connection = new ConnectionRepository().create({
      provider: 'cloudflare',
      scope: 'hypervibe.dev',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'cloudflare-token' }),
    });
    new ConnectionRepository().updateStatus(connection.id, 'verified');
    vi.spyOn(CloudflareAdapter.prototype, 'findZoneByName').mockResolvedValue({
      id: 'zone-1', name: 'hypervibe.dev', status: 'active', paused: false, type: 'full', name_servers: [],
    });
    vi.spyOn(CloudflareAdapter.prototype, 'listDnsRecords').mockResolvedValue([]);
    vi.spyOn(GitHubAdapter.prototype, 'getPagesConfig').mockResolvedValue(null);
    const adapter = new GitHubAdapter();
    adapter.connect({ apiToken: 'github-token' });

    const planned = await planGitHubPages({ spec: desiredSpec, repository: REPOSITORY, adapter });
    const dnsAction = planned.actions.find((action) => action.metadata?.operation === GITHUB_PAGES_DNS_OPERATION)!;
    const pagesAction = planned.actions.find((action) => action.id === GITHUB_PAGES_ACTION_ID)!;

    expect(dnsAction).toMatchObject({ type: 'update' });
    expect(dnsAction.dependsOn).toBeUndefined();
    expect(pagesAction).toMatchObject({ type: 'create', dependsOn: [dnsAction.id] });
  });

  it('blocks Pages mutation when provider state changed after planning', async () => {
    const desiredSpec = spec('pages-stale');
    const connection = new ConnectionRepository().create({
      provider: 'github',
      scope: REPOSITORY,
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'github-token' }),
    });
    new ConnectionRepository().updateStatus(connection.id, 'verified');
    vi.spyOn(GitHubAdapter.prototype, 'getPagesConfig').mockResolvedValue(pageConfig());
    const create = vi.spyOn(GitHubAdapter.prototype, 'createPagesSite');
    const update = vi.spyOn(GitHubAdapter.prototype, 'updatePagesSite');

    const result = await applyGitHubPages({
      spec: desiredSpec,
      action: {
        id: GITHUB_PAGES_ACTION_ID,
        type: 'create',
        resource: { kind: 'repo', name: REPOSITORY, provider: 'github' },
        verified: true,
        reason: 'Pages was absent during planning',
        metadata: {
          operation: 'githubPagesConfigure',
          repository: REPOSITORY,
          enabled: true,
          observed: null,
        },
      },
    });

    expect(result).toMatchObject({ success: false, status: 'blocked' });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

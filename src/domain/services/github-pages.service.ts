import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import {
  CloudflareAdapter,
  type CloudflareCredentials,
  type CloudflareDnsRecord,
} from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import {
  GitHubApiError,
  type GitHubAdapter,
  type GitHubPagesConfig,
} from '../../adapters/providers/github/github.adapter.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { GitHubPagesSpec, ProjectSpec } from '../spec/spec.schema.js';
import { formatConnectionGuidance } from './connection-guidance.js';
import {
  cloudflareScopeHintsForDomain,
  dnsZoneScopeForDomain,
} from './domain-scope.js';
import { getGitHubAdapter } from './github-ops.service.js';

export const GITHUB_PAGES_WORKFLOW_PATH = '.github/workflows/hypervibe-pages.yml';
export const GITHUB_PAGES_ACTION_ID = 'repo:github-pages';
export const GITHUB_PAGES_OPERATION = 'githubPagesConfigure';
export const GITHUB_PAGES_DNS_OPERATION = 'githubPagesDnsSync';

const GITHUB_PAGES_IPV4 = [
  '185.199.108.153',
  '185.199.109.153',
  '185.199.110.153',
  '185.199.111.153',
];

type ConnectionBlock = {
  provider: string;
  reason: string;
  scope?: string;
  policy: 'hard';
  actionIds: string[];
};

type DesiredDnsRecord = Pick<CloudflareDnsRecord, 'name' | 'type' | 'content' | 'proxied'>;
type DnsRecordSnapshot = Pick<CloudflareDnsRecord, 'id' | 'name' | 'type' | 'content' | 'proxied'>;

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function compileGitHubPagesWorkflow(pages: GitHubPagesSpec): string {
  const sourceGlob = `${pages.sourcePath}/**`;
  return [
    '# Managed by Hypervibe. Change desired state with hv_spec; manual edits will be reconciled.',
    'name: "Hypervibe / pages"',
    '',
    'on:',
    '  push:',
    `    branches: [${yamlString(pages.branch)}]`,
    '    paths:',
    `      - ${yamlString(sourceGlob)}`,
    `      - ${yamlString(GITHUB_PAGES_WORKFLOW_PATH)}`,
    '  workflow_dispatch:',
    '',
    'permissions:',
    '  contents: read',
    '  pages: write',
    '  id-token: write',
    '',
    'concurrency:',
    '  group: github-pages',
    '  cancel-in-progress: false',
    '',
    'jobs:',
    '  deploy:',
    '    environment:',
    '      name: github-pages',
    '      url: ${{ steps.deployment.outputs.page_url }}',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Checkout',
    '        uses: actions/checkout@v5',
    '        with:',
    '          persist-credentials: false',
    '      - name: Configure Pages',
    '        uses: actions/configure-pages@v5',
    '      - name: Upload static site',
    '        uses: actions/upload-pages-artifact@v4',
    '        with:',
    `          path: ${yamlString(pages.sourcePath)}`,
    '      - name: Deploy Pages',
    '        id: deployment',
    '        uses: actions/deploy-pages@v4',
    '',
  ].join('\n');
}

function repoParts(repository: string): { owner: string; repo: string } | null {
  const [owner, repo] = repository.split('/');
  return owner && repo ? { owner, repo } : null;
}

function normalizePages(config: GitHubPagesConfig | null): Record<string, unknown> | null {
  if (!config) return null;
  return {
    buildType: config.build_type ?? null,
    cname: config.cname ?? null,
    httpsEnforced: config.https_enforced ?? false,
  };
}

function dnsActionId(domain: string): string {
  return `domain:${domain}:github-pages-dns`;
}

function isApex(domain: string): boolean {
  return dnsZoneScopeForDomain(domain) === domain;
}

function desiredDnsRecords(domain: string, owner: string): DesiredDnsRecord[] {
  return isApex(domain)
    ? [
        ...GITHUB_PAGES_IPV4.map((content) => ({ name: domain, type: 'A', content, proxied: false as const })),
        { name: `www.${domain}`, type: 'CNAME', content: `${owner}.github.io`, proxied: false as const },
      ]
    : [{ name: domain, type: 'CNAME', content: `${owner}.github.io`, proxied: false as const }];
}

function normalizedDnsValue(value: string): string {
  return value.replace(/\.$/, '').toLowerCase();
}

function recordAtManagedName(record: CloudflareDnsRecord, desired: DesiredDnsRecord[]): boolean {
  const name = normalizedDnsValue(record.name);
  return desired.some((candidate) => normalizedDnsValue(candidate.name) === name);
}

function isAddressRecord(record: CloudflareDnsRecord): boolean {
  return ['A', 'AAAA', 'CNAME'].includes(record.type);
}

function dnsSnapshot(records: CloudflareDnsRecord[]): DnsRecordSnapshot[] {
  return records
    .map(({ id, name, type, content, proxied }) => ({ id, name, type, content, proxied }))
    .sort((a, b) => `${a.name}:${a.type}:${a.content}:${a.id}`.localeCompare(`${b.name}:${b.type}:${b.content}:${b.id}`));
}

function recordTuple(record: DesiredDnsRecord, includeProxy = true): string {
  return [
    normalizedDnsValue(record.name),
    record.type.toUpperCase(),
    normalizedDnsValue(record.content),
    ...(includeProxy ? [String(record.proxied)] : []),
  ].join(':');
}

function dnsInSync(current: DnsRecordSnapshot[], desired: DesiredDnsRecord[]): boolean {
  const tuples = (values: DesiredDnsRecord[]) => values
    .map((record) => recordTuple(record))
    .sort();
  return JSON.stringify(tuples(current)) === JSON.stringify(tuples(desired));
}

function recordsToDelete(current: DnsRecordSnapshot[], desired: DesiredDnsRecord[], enabled: boolean): DnsRecordSnapshot[] {
  if (!enabled) {
    const managed = new Set(desired.map((record) => recordTuple(record, false)));
    return current.filter((record) => managed.has(recordTuple(record, false)));
  }

  const remaining = new Map<string, number>();
  for (const record of desired) {
    const key = recordTuple(record);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return current.filter((record) => {
    const key = recordTuple(record);
    const count = remaining.get(key) ?? 0;
    if (count === 0) return true;
    remaining.set(key, count - 1);
    return false;
  });
}

function cloudflareAdapter(domain: string): { adapter: CloudflareAdapter } | { error: string } {
  const connections = new ConnectionRepository();
  const connection = connections.findBestVerifiedMatchFromHints(
    'cloudflare',
    cloudflareScopeHintsForDomain(domain)
  );
  if (!connection) {
    return {
      error: `No verified Cloudflare connection for ${domain}. ${formatConnectionGuidance('cloudflare', {
        scope: dnsZoneScopeForDomain(domain),
      })}`,
    };
  }
  const adapter = new CloudflareAdapter();
  adapter.connect(getSecretStore().decryptObject<CloudflareCredentials>(connection.credentialsEncrypted));
  return { adapter };
}

async function planPagesDns(params: {
  pages: GitHubPagesSpec;
  repository: string;
  owner: string;
  pageActionId: string;
}): Promise<{ actions: PlanAction[]; warnings: string[]; blocked: ConnectionBlock[] }> {
  const domain = params.pages.customDomain;
  if (!domain) return { actions: [], warnings: [], blocked: [] };
  const id = dnsActionId(domain);
  const desired = desiredDnsRecords(domain, params.owner);
  const result = cloudflareAdapter(domain);
  if ('error' in result) {
    return {
      actions: [{
        id,
        type: params.pages.enabled ? 'update' : 'destroy',
        resource: { kind: 'domain', name: domain, provider: 'cloudflare' },
        verified: false,
        reason: `Cannot observe GitHub Pages DNS for ${domain}`,
        ...(!params.pages.enabled ? { requiresConfirm: true } : {}),
        metadata: {
          operation: GITHUB_PAGES_DNS_OPERATION,
          repository: params.repository,
          enabled: params.pages.enabled,
          desiredRecords: desired,
          blockedReason: 'cloudflare_connection_unavailable',
        },
      }],
      warnings: [result.error],
      blocked: [{
        provider: 'cloudflare',
        scope: dnsZoneScopeForDomain(domain),
        policy: 'hard',
        actionIds: [id],
        reason: result.error,
      }],
    };
  }
  try {
    const zoneName = dnsZoneScopeForDomain(domain);
    const zone = await result.adapter.findZoneByName(zoneName);
    if (!zone) {
      const reason = `Cloudflare zone ${zoneName} was not found for GitHub Pages domain ${domain}.`;
      return {
        actions: [{
          id,
          type: params.pages.enabled ? 'update' : 'destroy',
          resource: { kind: 'domain', name: domain, provider: 'cloudflare' },
          verified: true,
          reason,
          ...(!params.pages.enabled ? { requiresConfirm: true } : {}),
          metadata: {
            operation: GITHUB_PAGES_DNS_OPERATION,
            repository: params.repository,
            enabled: params.pages.enabled,
            desiredRecords: desired,
            blockedReason: 'cloudflare_zone_absent',
          },
        }],
        warnings: [reason],
        blocked: [],
      };
    }
    const current = dnsSnapshot((await result.adapter.listDnsRecords(zone.id)).filter((record) => (
      recordAtManagedName(record, desired) && isAddressRecord(record)
    )));
    const matchingPagesRecords = current.filter((record) => desired.some((candidate) => (
      recordTuple(candidate, false) === recordTuple(record, false)
    )));
    const enabled = params.pages.enabled;
    const inSync = enabled ? dnsInSync(current, desired) : matchingPagesRecords.length === 0;
    const replacingExisting = enabled && recordsToDelete(current, desired, true).length > 0;
    return {
      actions: [{
        id,
        type: inSync ? 'noop' : enabled ? 'update' : 'destroy',
        resource: { kind: 'domain', name: domain, provider: 'cloudflare' },
        verified: true,
        reason: inSync
          ? `GitHub Pages DNS is in sync for ${domain}`
          : enabled
            ? `GitHub Pages DNS must point ${domain} at ${params.owner}.github.io`
            : `Remove Hypervibe-managed GitHub Pages DNS from ${domain}`,
        ...((replacingExisting || !enabled) && !inSync ? { requiresConfirm: true } : {}),
        ...(!enabled && !inSync ? { dependsOn: [params.pageActionId] } : {}),
        metadata: {
          operation: GITHUB_PAGES_DNS_OPERATION,
          repository: params.repository,
          enabled,
          zoneId: zone.id,
          zoneName: zone.name,
          desiredRecords: desired,
          observedRecords: current,
        },
      }],
      warnings: [],
      blocked: [],
    };
  } catch (error) {
    const reason = `Cannot observe Cloudflare DNS for ${domain}: ${error instanceof Error ? error.message : String(error)}`;
    return {
      actions: [{
        id,
        type: params.pages.enabled ? 'update' : 'destroy',
        resource: { kind: 'domain', name: domain, provider: 'cloudflare' },
        verified: false,
        reason,
        ...(!params.pages.enabled ? { requiresConfirm: true } : {}),
        metadata: {
          operation: GITHUB_PAGES_DNS_OPERATION,
          repository: params.repository,
          enabled: params.pages.enabled,
          desiredRecords: desired,
          blockedReason: 'github_pages_dns_observation_unknown',
        },
      }],
      warnings: [reason],
      blocked: [],
    };
  }
}

export async function planGitHubPages(params: {
  spec: ProjectSpec;
  repository: string;
  adapter: GitHubAdapter;
}): Promise<{ actions: PlanAction[]; warnings: string[]; blocked: ConnectionBlock[] }> {
  const pages = params.spec.github?.pages;
  if (!pages) return { actions: [], warnings: [], blocked: [] };
  const parts = repoParts(params.repository);
  if (!parts) return { actions: [], warnings: [`Could not parse GitHub Pages repository ${params.repository}.`], blocked: [] };

  let current: GitHubPagesConfig | null;
  try {
    current = await params.adapter.getPagesConfig(parts.owner, parts.repo);
  } catch (error) {
    const reason = `Cannot observe GitHub Pages for ${params.repository}: ${error instanceof Error ? error.message : String(error)}`;
    return {
      actions: [{
        id: GITHUB_PAGES_ACTION_ID,
        type: pages.enabled ? 'update' : 'destroy',
        resource: { kind: 'repo', name: params.repository, provider: 'github' },
        verified: false,
        reason,
        metadata: {
          operation: GITHUB_PAGES_OPERATION,
          repository: params.repository,
          enabled: pages.enabled,
          blockedReason: 'github_pages_observation_unknown',
        },
      }],
      warnings: [reason],
      blocked: [],
    };
  }

  const desiredCname = pages.customDomain ?? null;
  if (current?.cname && current.cname !== desiredCname) {
    const reason = `GitHub Pages currently uses ${current.cname}; remove that domain declaratively before selecting ${desiredCname ?? 'no custom domain'}.`;
    return {
      actions: [{
        id: GITHUB_PAGES_ACTION_ID,
        type: pages.enabled ? 'update' : 'destroy',
        resource: { kind: 'repo', name: params.repository, provider: 'github' },
        verified: true,
        reason,
        metadata: {
          operation: GITHUB_PAGES_OPERATION,
          repository: params.repository,
          enabled: pages.enabled,
          observed: normalizePages(current),
          blockedReason: 'github_pages_domain_change_requires_teardown',
        },
      }],
      warnings: [`${reason} Set pages.enabled=false while retaining the current customDomain, apply the confirmed teardown, then declare the replacement.`],
      blocked: [],
    };
  }

  const dns = await planPagesDns({
    pages,
    repository: params.repository,
    owner: parts.owner,
    pageActionId: GITHUB_PAGES_ACTION_ID,
  });
  const enabled = pages.enabled;
  const baseInSync = Boolean(current)
    && current?.build_type === 'workflow'
    && (current?.cname ?? null) === desiredCname;
  const httpsInSync = current?.https_enforced === true;
  const inSync = enabled ? baseInSync && httpsInSync : current === null;
  const dnsDependency = enabled
    ? dns.actions.find((action) => action.type !== 'noop')?.id
    : undefined;
  const pageAction: PlanAction = {
    id: GITHUB_PAGES_ACTION_ID,
    type: inSync ? 'noop' : enabled ? (current ? 'update' : 'create') : 'destroy',
    resource: { kind: 'repo', name: params.repository, provider: 'github' },
    verified: true,
    reason: inSync
      ? 'GitHub Pages configuration is in sync'
      : enabled
        ? `Configure ${params.repository} to publish ${pages.sourcePath} through GitHub Actions`
        : `Disable the Hypervibe-managed GitHub Pages site for ${params.repository}`,
    ...(!enabled && current ? { requiresConfirm: true } : {}),
    ...(dnsDependency ? { dependsOn: [dnsDependency] } : {}),
    metadata: {
      operation: GITHUB_PAGES_OPERATION,
      repository: params.repository,
      enabled,
      sourcePath: pages.sourcePath,
      branch: pages.branch,
      desiredCname,
      observed: normalizePages(current),
    },
  };
  return {
    actions: enabled ? [...dns.actions, pageAction] : [pageAction, ...dns.actions],
    warnings: [...dns.warnings],
    blocked: dns.blocked,
  };
}

export function isGitHubPagesAction(action: PlanAction): boolean {
  return action.metadata?.operation === GITHUB_PAGES_OPERATION;
}

export function isGitHubPagesDnsAction(action: PlanAction): boolean {
  return action.metadata?.operation === GITHUB_PAGES_DNS_OPERATION;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function applyGitHubPages(params: {
  spec: ProjectSpec;
  action: PlanAction;
}): Promise<{ success: boolean; status?: 'pending' | 'blocked'; message: string; error?: string; data?: Record<string, unknown> }> {
  const repository = typeof params.action.metadata?.repository === 'string' ? params.action.metadata.repository : undefined;
  const desired = params.spec.github?.pages;
  const reviewedEnabled = params.action.metadata?.enabled;
  const parts = repository ? repoParts(repository) : null;
  if (!repository || !parts || !desired || reviewedEnabled !== desired.enabled || params.action.resource.name !== repository) {
    return { success: false, status: 'blocked', message: 'GitHub Pages action has stale identity', error: 'Re-run hv_plan.' };
  }
  if (params.action.metadata?.blockedReason === 'github_pages_domain_change_requires_teardown') {
    return { success: false, status: 'blocked', message: 'GitHub Pages domain migration requires an explicit teardown stage', error: 'Re-run hv_plan after disabling the current custom domain.' };
  }
  const adapterResult = getGitHubAdapter(repository);
  if ('error' in adapterResult) {
    return { success: false, status: 'blocked', message: 'GitHub connection is unavailable', error: adapterResult.error };
  }
  const adapter = adapterResult.adapter;
  const current = await adapter.getPagesConfig(parts.owner, parts.repo);
  if (!sameJson(normalizePages(current), params.action.metadata?.observed ?? null)) {
    return { success: false, status: 'blocked', message: 'GitHub Pages changed after planning', error: 'Re-run hv_plan.' };
  }
  if (!desired.enabled) {
    if (current) await adapter.deletePagesSite(parts.owner, parts.repo);
    if (await adapter.getPagesConfig(parts.owner, parts.repo)) {
      return { success: false, message: 'GitHub Pages deletion was not verified', error: 'The Pages site still exists.' };
    }
    return { success: true, message: `Disabled GitHub Pages for ${repository}`, data: { repository } };
  }
  const configurationChanged = !current
    || current.build_type !== 'workflow'
    || (current.cname ?? null) !== (desired.customDomain ?? null);
  if (!current) {
    await adapter.createPagesSite(parts.owner, parts.repo, { buildType: 'workflow' });
  }
  await adapter.updatePagesSite(parts.owner, parts.repo, {
    buildType: 'workflow',
    cname: desired.customDomain ?? null,
  });
  const configured = await adapter.getPagesConfig(parts.owner, parts.repo);
  if (!configured || configured.build_type !== 'workflow' || (configured.cname ?? null) !== (desired.customDomain ?? null)) {
    return { success: false, message: 'GitHub Pages configuration was not verified', error: 'Provider read-back differs from desired state.' };
  }
  if (configured.https_enforced !== true) {
    try {
      await adapter.updatePagesSite(parts.owner, parts.repo, { httpsEnforced: true });
    } catch (error) {
      const certificatePending = desired.customDomain
        && error instanceof GitHubApiError
        && [400, 404, 409, 422].includes(error.status)
        && /https|certificate|domain/i.test(error.message);
      if (!certificatePending) throw error;
      if (configurationChanged) {
        await adapter.triggerWorkflow(parts.owner, parts.repo, GITHUB_PAGES_WORKFLOW_PATH, desired.branch);
      }
      return {
        success: true,
        status: 'pending',
        message: `GitHub Pages is configured for ${desired.customDomain}; GitHub has not made HTTPS enforcement available yet`,
        data: {
          repository,
          domain: desired.customDomain,
          certificateState: configured.https_certificate?.state ?? null,
          providerStatus: error.status,
          ...(configurationChanged ? { workflow: GITHUB_PAGES_WORKFLOW_PATH, ref: desired.branch } : {}),
        },
      };
    }
  }
  const verified = await adapter.getPagesConfig(parts.owner, parts.repo);
  if (!verified || verified.build_type !== 'workflow' || verified.https_enforced !== true) {
    return { success: false, message: 'GitHub Pages HTTPS configuration was not verified', error: 'Provider read-back differs from desired state.' };
  }
  if (configurationChanged) {
    await adapter.triggerWorkflow(parts.owner, parts.repo, GITHUB_PAGES_WORKFLOW_PATH, desired.branch);
    return {
      success: true,
      status: 'pending',
      message: `Configured GitHub Pages for ${repository}; the reviewed deployment workflow is pending`,
      data: { repository, domain: desired.customDomain ?? null, workflow: GITHUB_PAGES_WORKFLOW_PATH, ref: desired.branch },
    };
  }
  return {
    success: true,
    message: `Configured GitHub Pages for ${repository}`,
    data: { repository, domain: desired.customDomain ?? null, url: verified.url ?? null },
  };
}

function parseRecordArray(value: unknown): DnsRecordSnapshot[] | null {
  if (!Array.isArray(value)) return null;
  const records: DnsRecordSnapshot[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== 'string'
      || typeof record.name !== 'string'
      || typeof record.type !== 'string'
      || typeof record.content !== 'string'
      || typeof record.proxied !== 'boolean'
    ) return null;
    records.push({ id: record.id, name: record.name, type: record.type, content: record.content, proxied: record.proxied });
  }
  return records.sort((a, b) => `${a.name}:${a.type}:${a.content}:${a.id}`.localeCompare(`${b.name}:${b.type}:${b.content}:${b.id}`));
}

export async function applyGitHubPagesDns(params: {
  spec: ProjectSpec;
  action: PlanAction;
}): Promise<{ success: boolean; status?: 'blocked'; message: string; error?: string; data?: Record<string, unknown> }> {
  const pages = params.spec.github?.pages;
  const domain = pages?.customDomain;
  const repository = typeof params.action.metadata?.repository === 'string' ? params.action.metadata.repository : undefined;
  const reviewedEnabled = params.action.metadata?.enabled;
  const parts = repository ? repoParts(repository) : null;
  if (!pages || !domain || !repository || !parts || reviewedEnabled !== pages.enabled || params.action.resource.name !== domain) {
    return { success: false, status: 'blocked', message: 'GitHub Pages DNS action has stale identity', error: 'Re-run hv_plan.' };
  }
  const result = cloudflareAdapter(domain);
  if ('error' in result) {
    return { success: false, status: 'blocked', message: 'Cloudflare connection is unavailable', error: result.error };
  }
  const zoneId = typeof params.action.metadata?.zoneId === 'string' ? params.action.metadata.zoneId : undefined;
  const observed = parseRecordArray(params.action.metadata?.observedRecords);
  if (!zoneId || !observed) {
    return { success: false, status: 'blocked', message: 'GitHub Pages DNS was not safely observed during planning', error: 'Re-run hv_plan.' };
  }
  const desired = desiredDnsRecords(domain, parts.owner);
  const current = dnsSnapshot((await result.adapter.listDnsRecords(zoneId)).filter((record) => (
    recordAtManagedName(record, desired) && isAddressRecord(record)
  )));
  if (!sameJson(current, observed)) {
    return { success: false, status: 'blocked', message: `DNS for ${domain} changed after planning`, error: 'Re-run hv_plan.' };
  }
  for (const record of recordsToDelete(current, desired, pages.enabled)) {
    await result.adapter.deleteDnsRecord(zoneId, record.id);
  }
  if (pages.enabled) {
    const remaining = dnsSnapshot((await result.adapter.listDnsRecords(zoneId)).filter((record) => (
      recordAtManagedName(record, desired) && isAddressRecord(record)
    )));
    for (const record of desired) {
      const exists = remaining.some((candidate) => (
        recordTuple(candidate) === recordTuple(record)
      ));
      if (!exists) {
        await result.adapter.createDnsRecord(zoneId, record);
      }
    }
  }
  const finalRecords = dnsSnapshot((await result.adapter.listDnsRecords(zoneId)).filter((record) => (
    recordAtManagedName(record, desired) && isAddressRecord(record)
  )));
  const success = pages.enabled
    ? dnsInSync(finalRecords, desired)
    : finalRecords.every((record) => !desired.some((candidate) => (
      recordTuple(candidate, false) === recordTuple(record, false)
    )));
  if (!success) {
    return { success: false, message: `GitHub Pages DNS for ${domain} was not verified`, error: 'Provider read-back differs from desired state.' };
  }

  return {
    success: true,
    message: pages.enabled ? `Configured GitHub Pages DNS for ${domain}` : `Removed GitHub Pages DNS for ${domain}`,
    data: { repository, domain, recordCount: finalRecords.length },
  };
}

import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import {
  CloudflareAdapter,
  type CloudflareCredentials,
  type CloudflareDnsRecord,
} from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import {
  GitHubApiError,
  type GitHubAdapter,
  type GitHubPagesConfig,
  type GitHubPagesDomainHealth,
  type GitHubPagesHealthCheck,
} from '../../adapters/providers/github/github.adapter.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import type { PlanAction } from '../plan/plan.types.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Project } from '../entities/project.entity.js';
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
export const GITHUB_PAGES_BINDING_CLEANUP_OPERATION = 'githubPagesBindingCleanup';
export const GITHUB_PAGES_DNS_OPERATION = 'githubPagesDnsSync';

const GITHUB_PAGES_IPV4 = [
  '185.199.108.153',
  '185.199.109.153',
  '185.199.110.153',
  '185.199.111.153',
];
const GITHUB_PAGES_CERTIFICATE_ATTEMPT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

type CertificateAttempt = {
  domain: string;
  attemptedAt: string;
  mode: 'configuration' | 'reattach';
};

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
    '        uses: actions/configure-pages@v6',
    '      - name: Upload static site',
    '        uses: actions/upload-pages-artifact@v5',
    '        with:',
    `          path: ${yamlString(pages.sourcePath)}`,
    '      - name: Deploy Pages',
    '        id: deployment',
    '        uses: actions/deploy-pages@v5',
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function certificateAttempt(environment: Pick<Environment, 'platformBindings'> | null | undefined): CertificateAttempt | null {
  const github = asRecord(environment?.platformBindings.github);
  const raw = asRecord(github?.pagesCertificateAttempt);
  if (
    !raw
    || typeof raw.domain !== 'string'
    || typeof raw.attemptedAt !== 'string'
    || !['configuration', 'reattach'].includes(String(raw.mode))
    || !Number.isFinite(Date.parse(raw.attemptedAt))
  ) return null;
  return raw as CertificateAttempt;
}

function recordCertificateAttempt(params: {
  project: Project;
  environmentName: string;
  domain: string;
  mode: CertificateAttempt['mode'];
}): void {
  const environments = new EnvironmentRepository();
  const environment = environments.findByProjectAndName(params.project.id, params.environmentName)
    ?? environments.create({ projectId: params.project.id, name: params.environmentName });
  const github = asRecord(environment.platformBindings.github) ?? {};
  const attempt: CertificateAttempt = {
    domain: params.domain,
    attemptedAt: new Date().toISOString(),
    mode: params.mode,
  };
  environments.updatePlatformBindings(environment.id, {
    github: { ...github, pagesCertificateAttempt: attempt },
  });
}

function clearCertificateAttempt(params: {
  project: Project;
  environmentName: string;
}): void {
  const environments = new EnvironmentRepository();
  const environment = environments.findByProjectAndName(params.project.id, params.environmentName);
  if (!environment) return;
  const github = asRecord(environment.platformBindings.github);
  if (!github || !('pagesCertificateAttempt' in github)) return;
  const { pagesCertificateAttempt: _attempt, ...nextGitHub } = github;
  environments.updatePlatformBindings(environment.id, { github: nextGitHub });
}

function normalizeDomainHealth(domain: GitHubPagesDomainHealth | null | undefined): Record<string, unknown> | null {
  if (!domain) return null;
  return {
    host: domain.host ?? null,
    dnsResolves: domain.dns_resolves ?? null,
    isProxied: domain.is_proxied ?? null,
    isValidDomain: domain.is_valid_domain ?? null,
    pointsToGitHubPages: domain.is_pointed_to_github_pages_ip ?? null,
    isCnameToGitHubUserDomain: domain.is_cname_to_github_user_domain ?? null,
    isCnameToPagesDomain: domain.is_cname_to_pages_dot_github_dot_com ?? null,
    hasNonGitHubPagesIp: domain.is_non_github_pages_ip_present ?? null,
    isServedByPages: domain.is_served_by_pages ?? null,
    isHttpsEligible: domain.is_https_eligible ?? null,
    isValid: domain.is_valid ?? null,
    respondsToHttps: domain.responds_to_https ?? null,
    httpsError: domain.https_error ?? null,
    caaError: domain.caa_error ?? null,
  };
}

function normalizePagesHealth(health: GitHubPagesHealthCheck | null): Record<string, unknown> | null {
  if (!health) return null;
  return {
    domain: normalizeDomainHealth(health.domain),
    altDomain: normalizeDomainHealth(health.alt_domain),
  };
}

function dnsIsHealthyForCertificate(domain: GitHubPagesDomainHealth | null | undefined): boolean {
  const routesToPages = domain?.is_pointed_to_github_pages_ip === true
    || domain?.is_cname_to_github_user_domain === true
    || domain?.is_cname_to_pages_dot_github_dot_com === true;
  return Boolean(domain)
    && domain?.dns_resolves === true
    && domain.is_proxied === false
    && domain.is_valid_domain === true
    && routesToPages
    && domain.is_non_github_pages_ip_present === false
    && domain.is_served_by_pages === true
    && domain.is_https_eligible === true
    && domain.is_valid === true
    && domain.caa_error === null;
}

function certificateIsStuck(
  config: GitHubPagesConfig | null,
  health: GitHubPagesHealthCheck | null,
  desiredDomain: string
): boolean {
  const domain = health?.domain;
  const altDomain = health?.alt_domain;
  return Boolean(config)
    && config?.cname === desiredDomain
    && config.build_type === 'workflow'
    && config.https_enforced !== true
    && !config.https_certificate
    && dnsIsHealthyForCertificate(domain)
    && (altDomain == null || dnsIsHealthyForCertificate(altDomain))
    && domain?.responds_to_https === false
    && domain.https_error === 'peer_failed_verification';
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
  environment?: Pick<Environment, 'platformBindings'> | null;
}): Promise<{ actions: PlanAction[]; warnings: string[]; blocked: ConnectionBlock[] }> {
  const pages = params.spec.github?.pages;
  if (!pages) {
    const observedAttempt = certificateAttempt(params.environment);
    if (!observedAttempt) return { actions: [], warnings: [], blocked: [] };
    return {
      actions: [{
        id: GITHUB_PAGES_ACTION_ID,
        type: 'update',
        resource: { kind: 'repo', name: params.repository, provider: 'github' },
        verified: true,
        reason: 'Remove obsolete local GitHub Pages certificate-recovery metadata',
        metadata: {
          operation: GITHUB_PAGES_BINDING_CLEANUP_OPERATION,
          repository: params.repository,
          observedCertificateAttempt: observedAttempt,
        },
      }],
      warnings: [],
      blocked: [],
    };
  }
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
  let health: GitHubPagesHealthCheck | null = null;
  let healthObservationUnknown = false;
  const pagesWarnings: string[] = [];
  if (enabled && desiredCname && baseInSync && !httpsInSync && !current?.https_certificate) {
    try {
      health = await params.adapter.getPagesHealthCheck(parts.owner, parts.repo);
    } catch (error) {
      healthObservationUnknown = true;
      pagesWarnings.push(
        `Cannot verify whether GitHub Pages certificate recovery is safe for ${desiredCname}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const observedAttempt = certificateAttempt(params.environment);
  const matchingAttempt = observedAttempt?.domain === desiredCname ? observedAttempt : null;
  const attemptedAt = matchingAttempt ? Date.parse(matchingAttempt.attemptedAt) : Number.NaN;
  const recoveryCooldownActive = Number.isFinite(attemptedAt)
    && attemptedAt > Date.now() - GITHUB_PAGES_CERTIFICATE_ATTEMPT_COOLDOWN_MS;
  const stuckCertificate = Boolean(desiredCname)
    && certificateIsStuck(current, health, desiredCname!);
  const recoverCertificate = stuckCertificate && !recoveryCooldownActive;
  const recoveryCooldownUntil = recoveryCooldownActive
    ? new Date(attemptedAt + GITHUB_PAGES_CERTIFICATE_ATTEMPT_COOLDOWN_MS).toISOString()
    : undefined;
  const inSync = enabled ? baseInSync && httpsInSync : current === null;
  const dnsDependency = enabled
    ? dns.actions.find((action) => action.type !== 'noop')?.id
    : undefined;
  const pageAction: PlanAction = {
    id: GITHUB_PAGES_ACTION_ID,
    type: inSync ? 'noop' : enabled ? (current ? 'update' : 'create') : 'destroy',
    resource: { kind: 'repo', name: params.repository, provider: 'github' },
    verified: !healthObservationUnknown,
    reason: inSync
      ? 'GitHub Pages configuration is in sync'
      : healthObservationUnknown
        ? `GitHub Pages certificate health is not available for ${desiredCname}; retry planning after GitHub completes its DNS health check`
      : recoverCertificate
        ? `Restart stuck GitHub Pages certificate issuance for ${desiredCname} by reattaching the same custom domain`
        : recoveryCooldownUntil && stuckCertificate
          ? `GitHub Pages certificate issuance is pending; same-domain recovery is cooling down until ${recoveryCooldownUntil}`
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
      ...(healthObservationUnknown ? { blockedReason: 'github_pages_certificate_health_unknown' } : {}),
      ...(recoverCertificate ? {
        certificateRecovery: 'reattach',
        observedHealth: normalizePagesHealth(health),
        observedCertificateAttempt: matchingAttempt,
      } : {}),
      ...(recoveryCooldownUntil ? { certificateRecoveryCooldownUntil: recoveryCooldownUntil } : {}),
    },
  };
  return {
    actions: enabled ? [...dns.actions, pageAction] : [pageAction, ...dns.actions],
    warnings: [...dns.warnings, ...pagesWarnings],
    blocked: dns.blocked,
  };
}

export function isGitHubPagesAction(action: PlanAction): boolean {
  return action.metadata?.operation === GITHUB_PAGES_OPERATION;
}

export function isGitHubPagesBindingCleanupAction(action: PlanAction): boolean {
  return action.metadata?.operation === GITHUB_PAGES_BINDING_CLEANUP_OPERATION;
}

export function isGitHubPagesDnsAction(action: PlanAction): boolean {
  return action.metadata?.operation === GITHUB_PAGES_DNS_OPERATION;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function reattachPagesDomain(params: {
  adapter: GitHubAdapter;
  owner: string;
  repo: string;
  domain: string;
}): Promise<
  | { config: GitHubPagesConfig }
  | { error: string; domainPreserved: boolean; restorationError?: string }
> {
  try {
    await params.adapter.updatePagesSite(params.owner, params.repo, { cname: null });
    const detached = await params.adapter.getPagesConfig(params.owner, params.repo);
    if (!detached || detached.cname != null) {
      throw new Error('GitHub did not verify removal of the custom-domain association.');
    }
    await params.adapter.updatePagesSite(params.owner, params.repo, {
      buildType: 'workflow',
      cname: params.domain,
    });
    const restored = await params.adapter.getPagesConfig(params.owner, params.repo);
    if (!restored || restored.build_type !== 'workflow' || restored.cname !== params.domain) {
      throw new Error('GitHub did not verify restoration of the custom-domain association.');
    }
    return { config: restored };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await params.adapter.updatePagesSite(params.owner, params.repo, {
        buildType: 'workflow',
        cname: params.domain,
      });
      const restored = await params.adapter.getPagesConfig(params.owner, params.repo);
      if (!restored || restored.build_type !== 'workflow' || restored.cname !== params.domain) {
        throw new Error('Provider read-back did not confirm the original domain.');
      }
      return { error: message, domainPreserved: true };
    } catch (restorationError) {
      return {
        error: message,
        domainPreserved: false,
        restorationError: restorationError instanceof Error ? restorationError.message : String(restorationError),
      };
    }
  }
}

export async function applyGitHubPages(params: {
  spec: ProjectSpec;
  action: PlanAction;
  project?: Project;
  environmentName?: string;
}): Promise<{ success: boolean; status?: 'pending' | 'blocked'; message: string; error?: string; data?: Record<string, unknown> }> {
  const repository = typeof params.action.metadata?.repository === 'string' ? params.action.metadata.repository : undefined;
  const desired = params.spec.github?.pages;
  const reviewedEnabled = params.action.metadata?.enabled;
  const parts = repository ? repoParts(repository) : null;
  if (!repository || !parts || !desired || reviewedEnabled !== desired.enabled || params.action.resource.name !== repository) {
    return { success: false, status: 'blocked', message: 'GitHub Pages action has stale identity', error: 'Re-run hv_plan.' };
  }
  if (params.action.metadata?.blockedReason) {
    return { success: false, status: 'blocked', message: params.action.reason, error: 'Re-run hv_plan.' };
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
  const recovery = params.action.metadata?.certificateRecovery;
  if (recovery !== undefined && recovery !== 'reattach') {
    return { success: false, status: 'blocked', message: 'GitHub Pages certificate recovery action is invalid', error: 'Re-run hv_plan.' };
  }
  if (recovery === 'reattach') {
    if (!desired.enabled || !desired.customDomain || !params.project || !params.environmentName) {
      return { success: false, status: 'blocked', message: 'GitHub Pages certificate recovery has stale context', error: 'Re-run hv_plan.' };
    }
    const environment = new EnvironmentRepository().findByProjectAndName(params.project.id, params.environmentName);
    const liveAttempt = certificateAttempt(environment);
    const matchingLiveAttempt = liveAttempt?.domain === desired.customDomain ? liveAttempt : null;
    if (!sameJson(matchingLiveAttempt, params.action.metadata?.observedCertificateAttempt ?? null)) {
      return { success: false, status: 'blocked', message: 'GitHub Pages certificate recovery was already attempted after planning', error: 'Re-run hv_plan.' };
    }
    let health: GitHubPagesHealthCheck | null;
    try {
      health = await adapter.getPagesHealthCheck(parts.owner, parts.repo);
    } catch (error) {
      return {
        success: false,
        status: 'blocked',
        message: 'GitHub Pages certificate health could not be re-observed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (
      !sameJson(normalizePagesHealth(health), params.action.metadata?.observedHealth ?? null)
      || !certificateIsStuck(current, health, desired.customDomain)
    ) {
      return { success: false, status: 'blocked', message: 'GitHub Pages certificate health changed after planning', error: 'Re-run hv_plan.' };
    }
  }
  if (!desired.enabled) {
    if (current) await adapter.deletePagesSite(parts.owner, parts.repo);
    if (await adapter.getPagesConfig(parts.owner, parts.repo)) {
      return { success: false, message: 'GitHub Pages deletion was not verified', error: 'The Pages site still exists.' };
    }
    return { success: true, message: `Disabled GitHub Pages for ${repository}`, data: { repository } };
  }
  let configurationChanged = !current
    || current.build_type !== 'workflow'
    || (current.cname ?? null) !== (desired.customDomain ?? null);
  let configured: GitHubPagesConfig | null;
  if (recovery === 'reattach' && desired.customDomain) {
    const reattached = await reattachPagesDomain({
      adapter,
      owner: parts.owner,
      repo: parts.repo,
      domain: desired.customDomain,
    });
    if ('error' in reattached) {
      return {
        success: false,
        message: reattached.domainPreserved
          ? 'GitHub Pages certificate recovery failed, but the original custom domain was restored'
          : 'GitHub Pages certificate recovery failed and the custom domain could not be restored',
        error: reattached.restorationError
          ? `${reattached.error} Restoration failed: ${reattached.restorationError}`
          : reattached.error,
        data: { repository, domain: desired.customDomain, domainPreserved: reattached.domainPreserved },
      };
    }
    configured = reattached.config;
    configurationChanged = true;
    recordCertificateAttempt({
      project: params.project!,
      environmentName: params.environmentName!,
      domain: desired.customDomain,
      mode: 'reattach',
    });
  } else {
    if (!current) {
      await adapter.createPagesSite(parts.owner, parts.repo, { buildType: 'workflow' });
    }
    if (configurationChanged) {
      await adapter.updatePagesSite(parts.owner, parts.repo, {
        buildType: 'workflow',
        cname: desired.customDomain ?? null,
      });
      configured = await adapter.getPagesConfig(parts.owner, parts.repo);
    } else {
      configured = current;
    }
  }
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
      if (
        desired.customDomain
        && configurationChanged
        && recovery !== 'reattach'
        && params.project
        && params.environmentName
      ) {
        recordCertificateAttempt({
          project: params.project,
          environmentName: params.environmentName,
          domain: desired.customDomain,
          mode: 'configuration',
        });
      }
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

export async function applyGitHubPagesBindingCleanup(params: {
  spec: ProjectSpec;
  action: PlanAction;
  project: Project;
  environmentName: string;
}): Promise<{ success: boolean; status?: 'blocked'; message: string; error?: string; data?: Record<string, unknown> }> {
  const repository = typeof params.action.metadata?.repository === 'string' ? params.action.metadata.repository : undefined;
  if (
    !repository
    || !repoParts(repository)
    || params.action.resource.name !== repository
    || params.spec.github?.pages
  ) {
    return { success: false, status: 'blocked', message: 'GitHub Pages binding cleanup has stale identity', error: 'Re-run hv_plan.' };
  }
  const environment = new EnvironmentRepository().findByProjectAndName(params.project.id, params.environmentName);
  const liveAttempt = certificateAttempt(environment);
  if (!sameJson(liveAttempt, params.action.metadata?.observedCertificateAttempt ?? null)) {
    return { success: false, status: 'blocked', message: 'GitHub Pages binding metadata changed after planning', error: 'Re-run hv_plan.' };
  }
  clearCertificateAttempt({ project: params.project, environmentName: params.environmentName });
  return {
    success: true,
    message: `Removed obsolete GitHub Pages binding metadata for ${repository}`,
    data: { repository },
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

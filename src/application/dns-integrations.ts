import { createHash } from 'node:crypto';
import { GitHubAdapter, type GitHubCredentials, type GitHubPagesConfig } from '../adapters/providers/github/github.adapter.js';
import { SendGridAdapter, type SendGridCredentials } from '../adapters/providers/sendgrid/sendgrid.adapter.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import type { DnsRecordType } from '../domain/ports/dns.port.js';
import type { EnvironmentSpec, ProjectSpec } from '../domain/spec/spec.schema.js';
import { desiredEmailDnsRecords, EMAIL_OPERATIONS } from '../domain/services/email-plan.service.js';
import { desiredPagesDnsRecords, GITHUB_PAGES_ACTION_ID, GITHUB_PAGES_DNS_OPERATION } from '../domain/services/github-pages.service.js';
import { getProjectScopeHints } from '../domain/services/project-scope.js';
import { canonicalJsonSha256 } from '../lib/canonical-json.js';
import type { CommandContext } from './context.js';
import { hasOwnedDnsRecords, prepareDnsEnginePlan, type DesiredDnsRecord } from './dns-engine.js';
import { persistDnsPlanRun, type SavedDnsPlan } from './dns-hosting.js';

interface FrozenRecord { name: string; type: string; content: string; priority?: number; proxied?: boolean }
const dnsName = (value: string): string => value.toLowerCase().replace(/\.$/, '');
function frozenRecords(value: unknown): FrozenRecord[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 128) return undefined;
  const records: FrozenRecord[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    if (typeof record.name !== 'string' || typeof record.type !== 'string' || typeof record.content !== 'string'
      || !['A', 'AAAA', 'CNAME', 'TXT', 'CAA', 'MX'].includes(record.type)
      || (record.priority !== undefined && (typeof record.priority !== 'number' || !Number.isInteger(record.priority)))
      || (record.type === 'MX' && record.priority === undefined)) return undefined;
    records.push({ name: dnsName(record.name), type: record.type, content: record.type === 'TXT' ? record.content : record.content.toLowerCase().replace(/\.$/, ''),
      ...(typeof record.priority === 'number' ? { priority: record.priority } : {}) });
  }
  return records.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function recordsEqual(left: unknown, right: unknown): boolean {
  const a = frozenRecords(left); const b = frozenRecords(right);
  return Boolean(a && b && canonicalJsonSha256(a) === canonicalJsonSha256(b));
}
function engineRecords(records: FrozenRecord[], ttl: number): DesiredDnsRecord[] {
  const groups = new Map<string, DesiredDnsRecord>();
  for (const record of records) {
    const identity = JSON.stringify([record.name, record.type]);
    const value = record.type === 'MX' ? `${record.priority} ${record.content}.` : record.content;
    const existing = groups.get(identity);
    if (existing) existing.values = [...new Set([...existing.values, value])].sort();
    else groups.set(identity, {
      key: `integration_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`,
      name: record.name, type: record.type as DnsRecordType, values: [value], ttl,
      ...(['A', 'AAAA', 'CNAME'].includes(record.type) ? { proxied: false } : {}),
    });
  }
  return [...groups.values()];
}
function pagesSnapshot(config: GitHubPagesConfig | null): Record<string, unknown> | null {
  return config ? { buildType: config.build_type ?? null, cname: config.cname ?? null, httpsEnforced: config.https_enforced ?? false } : null;
}
function connectionFor(ctx: CommandContext, project: Project, source: Record<string, unknown>) {
  return source.kind === 'github-pages' && typeof source.repository === 'string'
    ? ctx.repos.connections.findBestVerifiedMatch('github', source.repository)
    : source.kind === 'sendgrid-domain' && typeof source.domain === 'string'
      ? ctx.repos.connections.findBestVerifiedMatchFromHints('sendgrid', [source.domain, ...getProjectScopeHints(project)])
      : null;
}

/** Fresh read before apply; never discovers a new mutation or generates a plan. */
export async function verifyDnsIntegrationSource(ctx: CommandContext, project: Project, environmentSpec: EnvironmentSpec, source: Record<string, unknown>): Promise<{ ready: boolean; reason?: string }> {
  const blocked = (reason: string) => ({ ready: false, reason });
  const connection = connectionFor(ctx, project, source);
  if (!connection || source.connectionId !== connection.id) return blocked('The verified DNS consumer connection changed. Run hv_plan again.');
  try {
    if (source.kind === 'github-pages') {
      if (typeof source.repository !== 'string' || typeof source.domain !== 'string' || typeof source.enabled !== 'boolean') return blocked('GitHub Pages DNS source is incomplete.');
      const [owner, repository, extra] = source.repository.split('/');
      if (!owner || !repository || extra || !recordsEqual(source.records, desiredPagesDnsRecords(source.domain, owner))) return blocked('GitHub Pages DNS targets do not match the reviewed repository.');
      const adapter = new GitHubAdapter();
      adapter.connect(ctx.secretStore.decryptObject<GitHubCredentials>(connection.credentialsEncrypted));
      const current = await adapter.getPagesConfig(owner, repository);
      if (canonicalJsonSha256(pagesSnapshot(current)) !== canonicalJsonSha256(source.observed)) return blocked('The GitHub Pages attachment changed after planning. Run hv_plan again.');
      if (!current || dnsName(current.cname ?? '') !== dnsName(source.domain)) return blocked('Keep the exact GitHub Pages hostname attached until its DNS removal is verified.');
      return { ready: true };
    }
    if (source.kind === 'sendgrid-domain') {
      if (!environmentSpec.email.enabled || !environmentSpec.domain || dnsName(environmentSpec.domain) !== source.domain || typeof source.authorizationId !== 'string') return blocked('The email DNS consumer changed after planning.');
      const adapter = new SendGridAdapter();
      adapter.connect(ctx.secretStore.decryptObject<SendGridCredentials>(connection.credentialsEncrypted));
      const authentications = await adapter.listDomainAuthentications();
      const matches = authentications.filter(auth => dnsName(auth.domain) === source.domain);
      if (matches.length !== 1 || String(matches[0]!.id) !== source.authorizationId) return blocked('The exact SendGrid domain authentication is missing or changed. Run hv_plan again.');
      const records = desiredEmailDnsRecords(environmentSpec, { domainAuthentications: { status: 'known', items: matches } });
      if (!recordsEqual(source.records, records)) return blocked('SendGrid changed its DNS targets after planning. Run hv_plan again.');
      return { ready: true };
    }
    return blocked('The DNS consumer source is unsupported.');
  } catch { return blocked('The DNS consumer could not be observed completely. DNS remains unchanged.'); }
}

export interface DnsIntegrationDependencies { prepare: typeof prepareDnsEnginePlan; verify: typeof verifyDnsIntegrationSource; persist: typeof persistDnsPlanRun }
const defaults: DnsIntegrationDependencies = { prepare: prepareDnsEnginePlan, verify: verifyDnsIntegrationSource, persist: persistDnsPlanRun };

/**
 * Replace legacy DNS mutations with a standalone saved engine stage, using only
 * records frozen by the ordinary planner's complete consumer observation.
 * The caller persists actions marked dnsEngineReady/Deferred before returning
 * its normal plan and clears only those actions' obsolete DNS connection blocks.
 */
export async function planPagesEmailDns(ctx: CommandContext, params: {
  project: Project; spec: ProjectSpec; environmentName: string; specRevision: number; actions: PlanAction[];
}, dependencies: DnsIntegrationDependencies = defaults): Promise<SavedDnsPlan | { blocked: string[] } | null> {
  const environmentSpec = params.spec.environments[params.environmentName];
  if (!environmentSpec) return null;
  const environment = ctx.repos.environments.findByProjectAndName(params.project.id, params.environmentName);
  if (!environment) return null;
  for (const action of params.actions) {
    const operation = action.metadata?.operation;
    const pages = operation === GITHUB_PAGES_DNS_OPERATION;
    const email = operation === EMAIL_OPERATIONS.dnsSync || operation === EMAIL_OPERATIONS.dnsAdopt;
    if (!pages && !email) continue;
    const owner = pages ? 'pages' : 'email';
    if (action.type === 'noop' && !environmentSpec.dns && !hasOwnedDnsRecords(environment, owner)) continue;
    const records = frozenRecords(action.metadata?.desiredRecords);
    let source: Record<string, unknown>;
    let removalPlanId: string | undefined;
    let pagesConsumer: PlanAction | undefined;
    if (pages) {
      const consumer = params.actions.find(item => item.id === GITHUB_PAGES_ACTION_ID);
      if (!consumer?.verified || consumer.metadata?.blockedReason) continue;
      const enabled = action.metadata?.enabled === true;
      const observed = consumer.metadata?.observed as Record<string, unknown> | null | undefined;
      const removal = (environment.platformBindings.github as { pagesDnsRemoved?: { domain?: string; repository?: string; planId?: string } } | undefined)?.pagesDnsRemoved;
      removalPlanId = removal?.domain === action.resource.name && removal.repository === action.metadata?.repository && typeof removal.planId === 'string'
        ? removal.planId : undefined;
      pagesConsumer = consumer;
      if (!enabled && observed === null && removalPlanId && !hasOwnedDnsRecords(environment, owner)) {
        action.type = 'noop'; action.verified = true; action.metadata = { ...action.metadata, dnsEngineReady: true };
        continue;
      }
      const attached = observed?.cname === action.resource.name;
      if (!attached) {
        if (!enabled) return { blocked: ['The Pages hostname claim is missing or changed. Restore its exact attachment before removing owned DNS.'] };
        action.metadata = { ...action.metadata, dnsEngineDeferred: true };
        action.dependsOn = [...new Set([...(action.dependsOn ?? []), consumer.id])];
        continue;
      }
      source = { kind: 'github-pages', repository: action.metadata?.repository, domain: action.resource.name, enabled, observed, records };
    } else {
      const consumer = params.actions.find(item => item.id === 'email:sendgrid:authorization');
      if (!consumer?.verified || consumer.type !== 'noop' || consumer.metadata?.blockedReason || consumer.metadata?.candidateExternalId !== action.metadata?.authorizationId) {
        action.metadata = { ...action.metadata, dnsEngineDeferred: true };
        continue;
      }
      source = { kind: 'sendgrid-domain', domain: dnsName(action.resource.name), authorizationId: action.metadata?.authorizationId, records };
    }
    if (!records) return { blocked: ['DNS records were not completely observed for this integration. Apply its prerequisite, then run hv_plan again.'] };
    const connection = connectionFor(ctx, params.project, source);
    if (!connection) return { blocked: ['The DNS consumer needs its exact verified provider connection before DNS planning.'] };
    source.connectionId = connection.id;
    const verification = await dependencies.verify(ctx, params.project, environmentSpec, source);
    if (!verification.ready) return { blocked: [verification.reason ?? 'The exact DNS consumer could not be verified.'] };
    const prepared = await dependencies.prepare({ ctx, project: params.project, environment, environmentSpec, owner,
      domain: action.resource.name, records: engineRecords(records, environmentSpec.dns?.ttl ?? 300), ...(pages && source.enabled === false ? { remove: true } : {}) });
    if (prepared.blocked?.length) return { blocked: prepared.blocked };
    if (prepared.ready) {
      if (pages && source.enabled === false) {
        if (!removalPlanId) return { blocked: ['Pages teardown has no verified DNS removal receipt. Preserve its hostname claim and reconcile exact DNS ownership before detaching it.'] };
        pagesConsumer!.metadata = { ...pagesConsumer!.metadata, dnsEngineRemoved: true, dnsRemovalPlanId: removalPlanId };
      }
      const { blockedReason: _blockedReason, ...metadata } = action.metadata ?? {};
      action.metadata = { ...metadata, dnsEngineReady: true };
      action.type = 'noop'; action.verified = true;
      action.reason = pages && source.enabled === false ? 'The engine confirmed removal of owned Pages DNS values.' : 'The engine verified the frozen DNS records for this integration.';
      delete action.requiresConfirm;
      continue;
    }
    return dependencies.persist(ctx, { ...params, environment, prepared, source });
  }
  return null;
}
